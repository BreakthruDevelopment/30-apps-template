#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and proves one can't delete the other's item.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

# Better Auth allows 3 sign-in/sign-up requests per 10 s per IP. Back-to-back runs (smoke right after seeding, or two
# users in a row) can hit it. On a 429, wait out the window and retry once.
post_auth() {
  local jar=$1 path=$2 payload=$3 code
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "$payload" "$BASE_URL$path")
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      echo "auth rate limit (429) on $path; waiting 11s and retrying once"
      sleep 11
      continue
    fi
    break
  done
  case "$code" in 2??) return 0 ;; *) echo "auth request to $path returned $code" >&2; return 1 ;; esac
}

signup() {
  local jar=$1 email=$2
  post_auth "$jar" /api/auth/sign-up/email "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/items")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d '{"title":"x"}' "$BASE_URL/api/items")
[ "$code" = "403" ] || fail "cross-origin create should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' \
  -d '{"title":"x"}' "$BASE_URL/api/items")
[ "$code" = "403" ] || fail "create without an Origin should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{nope' "$BASE_URL/api/items")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  --data-binary @- "$BASE_URL/api/items")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
pass "cross-origin, malformed and oversized writes refused"

item=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"title":"smoke item"}' "$BASE_URL/api/items") || fail "create item failed"
id=$(echo "$item" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] || fail "no item id in $item"
pass "user A created an item"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"title":"nul\u0000byte"}' "$BASE_URL/api/items")
[ "$code" = "400" ] || fail "a NUL byte in a title should be 400, got $code"
pass "NUL byte rejected with 400, not 500"

op="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
first=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"title\":\"smoke replay\",\"clientOpId\":\"$op\"}" "$BASE_URL/api/items") || fail "idempotent create failed"
second=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"title\":\"smoke replay\",\"clientOpId\":\"$op\"}" "$BASE_URL/api/items") || fail "idempotent replay failed"
replay_id=$(echo "$first" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ "$replay_id" = "$(echo "$second" | sed -E 's/.*"id":"([^"]+)".*/\1/')" ] || fail "a replayed op id must return the first item: $first vs $second"
curl -fsS -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/items/$replay_id" >/dev/null || fail "cleanup of the replay item failed"
pass "replaying a client op id returns the same item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_B" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "403" ] || fail "user B deleting A's item should be 403, got $code"
pass "user B blocked from A's item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/ai/summarize")
[ "$code" = "200" ] || fail "AI summary should be 200, got $code"
pass "AI summary responds"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "204" ] || fail "owner delete should be 204, got $code"
pass "owner deleted their item"

echo "SMOKE PASS"
