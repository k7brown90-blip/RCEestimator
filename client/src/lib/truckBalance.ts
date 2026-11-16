/**
 * Kyle, 2026-11-15: both trucks' cards draw on ONE Field Expenses financial account, so the
 * balance beside a truck is the ACCOUNT's, not the truck's own money. Said on every screen that
 * shows it: "Field Expenses account balance — shared by 2 trucks" when trucks share the account
 * (the real count from the server), plain "balance" when only one truck draws on it.
 */
export function isSharedAccount(sharedByTrucks: number | null | undefined): boolean {
  return (sharedByTrucks ?? 0) >= 2;
}

export function accountBalanceLabel(sharedByTrucks: number | null | undefined): string {
  return isSharedAccount(sharedByTrucks)
    ? `Field Expenses account balance — shared by ${sharedByTrucks} trucks`
    : "balance";
}
