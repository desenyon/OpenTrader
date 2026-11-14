export type Exchange = "LIVE" | "FRIENDS";
export type Side = "BUY" | "SELL";
export type Role = "OWNER" | "MODERATOR" | "MEMBER";
export interface User {
  id: string;
  handle: string;
  createdAt: string;
}
export interface Group {
  id: string;
  name: string;
  description: string;
  role: Role;
  memberCount: number;
  seasonId: string;
  treasury: string;
  createdAt: string;
}
export interface Wallet {
  id: string;
  exchange: Exchange;
  groupId: string | null;
  available: string;
  locked: string;
  total: string;
  initial: string;
}
export interface Outcome {
  id: string;
  label: string;
  probability: number;
  assetId?: string;
}
export interface MarketRules {
  condition: string;
  source: string;
  evidence: string;
  observationAt: string;
  voidPolicy: string;
  disputeHours: number;
  resolverId: string;
  reviewerIds: string[];
}
export interface Resolution {
  id: string;
  outcomeId: string | null;
  evidence: string;
  rationale: string;
  proposedBy: string;
  proposedAt: string;
  disputeUntil: string;
  state: string;
  disputes: {
    id: string;
    userId: string;
    rationale: string;
    createdAt: string;
  }[];
  reviews: { userId: string; decision: string; rationale: string }[];
}
export interface Market {
  id: string;
  exchange: Exchange;
  provider: "polymarket" | "kalshi" | null;
  groupId: string | null;
  question: string;
  description: string;
  category: string;
  outcomes: Outcome[];
  status: string;
  volume: number;
  liquidity: number;
  closeAt: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl?: string;
  sequence: number;
  b?: number;
  resolverId?: string;
  creatorId?: string;
  rules?: MarketRules;
  resolution?: Resolution;
  image?: string;
}
export interface BookLevel {
  price: number;
  quantity: number;
  source: "PEER" | "AMM" | "EXTERNAL";
}
export interface OrderBook {
  marketId: string;
  outcomeId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: string;
  stale: boolean;
  source: string;
  hash?: string;
}
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
export interface Fill {
  id: string;
  marketId: string;
  outcomeId: string;
  side: Side;
  quantity: number;
  cash: string;
  price: number;
  source: "PEER" | "AMM" | "EXTERNAL";
  createdAt: string;
  handle?: string;
  orderId?: string;
}
export interface Order {
  id: string;
  marketId: string;
  outcomeId: string;
  side: Side;
  quantity: number;
  filledQuantity: number;
  limitPrice: number;
  timeInForce: "IOC" | "GTC" | "GTD";
  status: string;
  createdAt: string;
  expiresAt: string | null;
  locked: string;
  question?: string;
  outcomeLabel?: string;
}
export interface Position {
  marketId: string;
  outcomeId: string;
  question: string;
  outcomeLabel: string;
  exchange: Exchange;
  groupId: string | null;
  quantity: number;
  locked: number;
  costBasis: string;
  markPrice: number;
  indicativeValue: string;
  liquidationValue: string;
  realizedPnl: string;
  unrealizedPnl: string;
  sourceUrl?: string;
  liquidationAvailable?: boolean;
  valuationAt?: string;
  valuationNote?: string;
}
export interface Quote {
  id: string;
  marketId: string;
  outcomeId: string;
  side: Side;
  quantity: number;
  filledQuantity: number;
  estimatedCash: string;
  averagePrice: number;
  afterProbability: number;
  expiresAt: string;
  sequence: number;
  executable: boolean;
  reason?: string;
  sources: {
    source: "PEER" | "AMM" | "EXTERNAL";
    quantity: number;
    cash: string;
  }[];
}
export interface OrderInput {
  marketId: string;
  outcomeId: string;
  side: Side;
  quantity: number;
  limitPrice: string;
  timeInForce: "IOC" | "GTC" | "GTD";
  maxTotalCost?: string;
  minTotalProceeds?: string;
  minFillQuantity?: number;
  expiresAt?: string;
  quoteId?: string;
  expectedSequence?: number;
  ruleVersion?: number;
}
export interface OrderReceipt {
  order: Order;
  fills: Fill[];
  spent: string;
  received: string;
  wallet: Wallet;
  sequence: number;
}
export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  marketId?: string;
  createdAt: string;
  readAt: string | null;
}
export interface Bootstrap {
  user: User | null;
  groups: Group[];
  wallets: Wallet[];
  notifications: Notification[];
  settings: {
    liveEnabled: boolean;
    registrationOpen: boolean;
    version: string;
  };
  activeGroupId?: string;
}
export interface LeaderboardRow {
  userId: string;
  handle: string;
  netWorth: string;
  pnl: string;
  returnPercent: number;
  tradeCount: number;
  brierScore: number | null;
  forecastCount: number;
  joinedAt: string;
}
export interface Member {
  id: string;
  handle: string;
  role: Role;
  joinedAt: string;
  status: string;
}
export interface Comment {
  id: string;
  marketId: string;
  userId: string;
  handle: string;
  body: string;
  createdAt: string;
}
export interface ApiError {
  error: string;
  code: string;
}
