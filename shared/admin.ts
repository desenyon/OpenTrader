export type AccountStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
export type AdminSection =
  | "users"
  | "wallets"
  | "positions"
  | "bets"
  | "fills"
  | "settlements"
  | "markets"
  | "treasuries"
  | "audit";
export type AdminAction = { reason?: string } & (
  | { type: "ACCOUNT_STATUS"; targetId: string; status: AccountStatus }
  | {
      type: "WALLET_ADJUSTMENT" | "TREASURY_ADJUSTMENT";
      targetId: string;
      amount: string;
    }
  | { type: "TRADING_PAUSE"; paused: boolean }
  | { type: "CANCEL_ORDER"; targetId: string }
  | { type: "HALT_MARKET" | "RESUME_MARKET" | "CLOSE_MARKET"; targetId: string }
);
export interface AdminRow {
  exchange?: "LIVE" | "FRIENDS";
  id: string;
  primary: string;
  secondary: string;
  scope: string;
  status: string;
  amount?: string;
  profit?: string;
  createdAt: string;
  detail?: string;
}
export interface AdminReport {
  section: AdminSection;
  rows: AdminRow[];
  total: number;
  offset: number;
  limit: number;
  summary: {
    users: number;
    pending: number;
    openOrders: number;
    markets: number;
    tradingPaused: boolean;
  };
}
