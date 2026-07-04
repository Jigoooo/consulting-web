-- ADR-0009 update: invitations are share-link based.
-- email is only an optional display/notification hint, never an access-control binding.
ALTER TABLE "invitations" ALTER COLUMN "email" DROP NOT NULL;
