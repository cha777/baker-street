import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

const parseCsv = (val: string, fallback: string[]): string[] => {
  const items = val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),
  ENCRYPTION_KEY: z.string().min(8).default('baker-street-default-secret-key-change-me-2026'),
  BRAINXHR_URL: z
    .string()
    .url()
    .default('https://brainxhr.directfn.net/private/task/cafe-order-food'),
  BRAINXHR_USERNAME: z.string().default(''),
  BRAINXHR_PASSWORD: z.string().default(''),
  DEFAULT_LOCATION: z.string().default('ICC Techno Hub'),
  DEFAULT_ORDER_FOR: z.string().default('My self'),
  DEFAULT_FOOD_TYPE: z.string().default('Chicken'),
  LOCATIONS: z.string().default('ICC Techno Hub,Villa'),
  ORDER_FOR_OPTIONS: z.string().default('My self,For a colleague,For a visitor'),
  FOOD_TYPES: z.string().default('Chicken,Egg,Fish,Vegetable'),
  TIMEZONE: z.string().default('Asia/Colombo'),
  DEFAULT_SCHEDULE_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format')
    .default('08:30'),
  HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
});

const parsed = envSchema.parse(process.env);

const allowedUserIds = parsed.TELEGRAM_ALLOWED_USER_IDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => !Number.isNaN(n));

export const config = {
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  allowedUserIds,
  encryptionKey: parsed.ENCRYPTION_KEY,
  brainxhrUrl: parsed.BRAINXHR_URL,
  cliFallbackCredentials: {
    username: parsed.BRAINXHR_USERNAME,
    password: parsed.BRAINXHR_PASSWORD,
  },
  defaults: {
    location: parsed.DEFAULT_LOCATION,
    orderFor: parsed.DEFAULT_ORDER_FOR,
    foodType: parsed.DEFAULT_FOOD_TYPE,
  },
  options: {
    locations: parseCsv(parsed.LOCATIONS, ['ICC Techno Hub', 'Villa']),
    orderFor: parseCsv(parsed.ORDER_FOR_OPTIONS, ['My self', 'For a colleague', 'For a visitor']),
    foodTypes: parseCsv(parsed.FOOD_TYPES, ['Chicken', 'Egg', 'Fish', 'Vegetable']),
  },
  timezone: parsed.TIMEZONE,
  defaultScheduleTime: parsed.DEFAULT_SCHEDULE_TIME,
  headless: parsed.HEADLESS,
  paths: {
    authDir: path.resolve(process.cwd(), '.auth'),
    dataDir: path.resolve(process.cwd(), 'data'),
    debugDir: path.resolve(process.cwd(), 'debug-dump'),
  },
};
