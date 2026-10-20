/**
 * Exact calibrated selectors for BrainxHR (ASP.NET WebForms) Login & Cafe Order Food page.
 */
export const SELECTORS = {
  login: {
    emailInput: '#txtiSignInEmail',
    passwordInput: '#txtiSignInPassword',
    rememberMeCheckbox: '#chbRememberMe',
    submitButton: '#btnLogin',
  },
  cafeOrder: {
    updateProgressIndicator: '#cphContent_CafeFoodOrderUC_ctl03',
    locationSelect: '#cphContent_CafeFoodOrderUC_ddCafeLocation',
    orderForSelect: '#cphContent_CafeFoodOrderUC_ddOrderFor',
    foodTypeSelect: '#cphContent_CafeFoodOrderUC_ddFoodType',
    submitButton: '#cphContent_CafeFoodOrderUC_btnSave',
    clearButton: '#cphContent_CafeFoodOrderUC_btnClear',
    deleteButton: '#cphContent_CafeFoodOrderUC_btnDelete',
    ordersTable: '#gridOrderedFood',
    selectableOrderRows: '#gridOrderedFood tr[onclick*="Select$"]',
    closedSignImage: 'img[src*="closed-sign.png"]',
    closedMessageText: 'text=/You cant place orders now/i',
    todayOrdersRadio: '#cphContent_CafeFoodOrderUC_rdbTodayOrder',
    orderHistoryRadio: '#cphContent_CafeFoodOrderUC_rdbOrderHistory',
  },
};

/**
 * Checks whether the current time in Sri Lanka (Asia/Colombo) is within the allowed
 * ordering/cancellation window: 12:00 AM (00:00) to 10:30 AM (10:30).
 */
export function getOrderingWindowStatus(timezone = 'Asia/Colombo'): {
  isOpen: boolean;
  currentTimeSL: string;
  minutesSinceMidnight: number;
  statusBanner: string;
} {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const rawHour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const hourStr = rawHour === '24' ? '00' : rawHour;
  const minuteStr = parts.find((p) => p.type === 'minute')?.value ?? '00';

  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const minutesSinceMidnight = hour * 60 + minute;

  // Open from 00:00 (0 mins) up to 10:30 AM (630 mins)
  const isOpen = minutesSinceMidnight >= 0 && minutesSinceMidnight < 10 * 60 + 30;
  const currentTimeSL = `${hourStr}:${minuteStr}`;

  const statusBanner = isOpen
    ? `🟢 *OPEN* (Closes at 10:30 AM • Current SL Time: \`${currentTimeSL}\`)`
    : `🔴 *CLOSED* (Open 12:00 AM – 10:30 AM • Current SL Time: \`${currentTimeSL}\`)`;

  return {
    isOpen,
    currentTimeSL,
    minutesSinceMidnight,
    statusBanner,
  };
}

/**
 * Validates whether a "HH:mm" schedule time falls within 00:00 to 10:25 SL time.
 */
export function isScheduleTimeWithinOrderingWindow(timeHHMM: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeHHMM.trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const totalMinutes = hour * 60 + minute;
  // Must be between 00:00 and 10:25 so the order completes before 10:30 AM cutoff
  return totalMinutes >= 0 && totalMinutes <= 10 * 60 + 25;
}

/**
 * Maps user-friendly option names to the exact <option> text/values in BrainxHR.
 */
export const OPTION_ALIASES: Record<string, string[]> = {
  'icc techno hub': ['ICC Techno Hub', 'icc techno hub', '3'],
  villa: ['Villa', 'villa', '2'],
  'my self': ['My Self', 'My self', 'my self', 'myself', '1'],
  'for a colleague': ['For a Colleague', 'For a colleague', 'For a college', '2'],
  'for a visitor': ['For a Visitor', 'For a visitor', '3'],
  chicken: ['Chicken', 'chicken', 'checken', '1'],
  egg: ['Egg', 'egg', '3'],
  fish: ['Fish', 'fish', '2'],
  vegetable: ['Vegetable', 'vegetable', 'vegitable', '5'],
};

export function getCandidateVariants(optionText: string): string[] {
  const normalized = optionText.trim().toLowerCase();
  const aliases = OPTION_ALIASES[normalized] ?? [];
  return Array.from(new Set([optionText.trim(), ...aliases, normalized]));
}
