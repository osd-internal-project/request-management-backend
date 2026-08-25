-- AlterTable
ALTER TABLE "users" ADD COLUMN     "keycloakRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];

