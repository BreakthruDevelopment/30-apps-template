ALTER TABLE "item" ADD COLUMN "client_op_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "item_owner_client_op_uidx" ON "item" USING btree ("owner_id","client_op_id");