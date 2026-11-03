# Infrastructure

Terraform for the four clouds lands here in the second half of Day 0, once the cloud accounts exist and each
module can be applied and tested for real rather than written blind.

| Folder | Runs the container on | Database | Notes |
| --- | --- | --- | --- |
| `aws/` | Lambda (container image) behind CloudFront | RDS from sign-up credits | Free plan account closes after 6 months |
| `azure/` | Container Apps (always-free grant) | Flexible Server B1MS (free 12 months) | Managed TLS for the custom domain |
| `gcp/` | Cloud Run in us-central1 (always-free) | Postgres on the always-free e2-micro | Managed TLS via domain mapping |
| `oci/` | Docker + Caddy on the Always Free Ampere A1 VM | Postgres on the same VM | Permanent demo host |

Every module takes the same inputs (`app_name`, `image`, `app_url`, `max_instances`) and reads secrets from that
cloud's secret manager. GitHub Actions authenticates with OIDC, so no long-lived cloud keys are stored in GitHub.

DNS for `breakthruventures.ai` stays at Network Solutions: each deploy prints the one record to add by hand.
