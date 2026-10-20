export interface UserCredentials {
  username: string;
  password: string;
}

export interface OrderRequest {
  location: string;
  orderFor: string;
  foodType: string;
  note?: string;
}

export interface UserSchedule {
  enabled: boolean;
  /** Time in 24-hour "HH:mm" format, e.g., "08:30" */
  time: string;
  /** Days of week where 0 = Sunday, 1 = Monday, ..., 6 = Saturday. Default: [1, 2, 3, 4, 5] (Mon-Fri) */
  daysOfWeek: number[];
  /** Last date ("YYYY-MM-DD") the scheduled order was triggered, preventing duplicate runs on the same day */
  lastRunDate?: string;
}

export interface UserProfile {
  telegramId: number;
  telegramUsername?: string;
  firstName?: string;
  brainxhrUsername: string;
  encryptedPassword: string;
  defaults: OrderRequest;
  schedule: UserSchedule;
  updatedAt: string;
}

export interface PlacedOrder {
  id: string;
  rowIndex: number;
  date?: string;
  location: string;
  orderFor: string;
  foodType: string;
  summary: string;
}

export interface AutomationResult {
  success: boolean;
  message: string;
  screenshotPath?: string;
  orders?: PlacedOrder[];
}
