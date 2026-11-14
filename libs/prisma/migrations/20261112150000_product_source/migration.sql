-- A product typed in on the Pricing pages while no ERP is connected
-- (`manual`). The SAP sync leaves those alone until SAP lists the same code.
ALTER TABLE "products" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'sap';
