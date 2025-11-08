-- Add cashflow tracking fields to PropertyHolding and downPayment/initialMortgageDebt
ALTER TABLE "PropertyHolding"
  ADD COLUMN "downPayment" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "initialMortgageDebt" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedRent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedInterestPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedTaxesPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedInsurancePaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedMaintenancePaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "accumulatedNetCashflow" DOUBLE PRECISION NOT NULL DEFAULT 0;