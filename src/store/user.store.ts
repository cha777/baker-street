import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { OrderRequest, UserCredentials, UserProfile, UserSchedule } from '../types.js';

const ALGORITHM = 'aes-256-gcm';
const SALT = 'baker-street-salt-v1';

function getKey(): Buffer {
  return crypto.scryptSync(config.encryptionKey, SALT, 32);
}

function encryptText(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptText(payload: string): string {
  const [ivHex, authTagHex, encryptedHex] = payload.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export class UserStore {
  private readonly filePath: string;
  private users: Map<number, UserProfile> = new Map();

  constructor() {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    fs.mkdirSync(config.paths.authDir, { recursive: true });
    this.filePath = path.join(config.paths.dataDir, 'users.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const list = JSON.parse(raw) as UserProfile[];
        this.users = new Map(list.map((u) => [u.telegramId, u]));
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load users.json, starting with empty store');
      this.users = new Map();
    }
  }

  private save(): void {
    const list = Array.from(this.users.values());
    fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf8');
  }

  public getUser(telegramId: number): UserProfile | undefined {
    return this.users.get(telegramId);
  }

  public getAllUsers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  public getCredentials(telegramId: number): UserCredentials | null {
    const user = this.users.get(telegramId);
    if (!user || !user.brainxhrUsername || !user.encryptedPassword) {
      return null;
    }
    try {
      return {
        username: user.brainxhrUsername,
        password: decryptText(user.encryptedPassword),
      };
    } catch (err) {
      logger.error({ err, telegramId }, 'Failed to decrypt user password');
      return null;
    }
  }

  public saveCredentials(
    telegramId: number,
    credentials: UserCredentials,
    meta?: { telegramUsername?: string; firstName?: string }
  ): UserProfile {
    const existing = this.users.get(telegramId);
    const profile: UserProfile = {
      telegramId,
      telegramUsername: meta?.telegramUsername ?? existing?.telegramUsername,
      firstName: meta?.firstName ?? existing?.firstName,
      brainxhrUsername: credentials.username.trim(),
      encryptedPassword: encryptText(credentials.password),
      defaults: existing?.defaults ?? {
        location: config.defaults.location,
        orderFor: config.defaults.orderFor,
        foodType: config.defaults.foodType,
      },
      schedule: existing?.schedule ?? {
        enabled: false,
        time: config.defaultScheduleTime,
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
      },
      updatedAt: new Date().toISOString(),
    };
    this.users.set(telegramId, profile);
    this.save();
    return profile;
  }

  public updateDefaults(telegramId: number, patch: Partial<OrderRequest>): UserProfile | null {
    const user = this.users.get(telegramId);
    if (!user) return null;
    user.defaults = {
      ...user.defaults,
      ...patch,
    };
    user.updatedAt = new Date().toISOString();
    this.users.set(telegramId, user);
    this.save();
    return user;
  }

  public updateSchedule(telegramId: number, patch: Partial<UserSchedule>): UserProfile | null {
    const user = this.users.get(telegramId);
    if (!user) return null;
    user.schedule = {
      ...user.schedule,
      ...patch,
    };
    user.updatedAt = new Date().toISOString();
    this.users.set(telegramId, user);
    this.save();
    return user;
  }

  public removeUser(telegramId: number): boolean {
    const existed = this.users.delete(telegramId);
    if (existed) {
      this.save();
    }
    const sessionPath = this.getStorageStatePath(telegramId);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
    return existed;
  }

  public getStorageStatePath(telegramId: number): string {
    return path.join(config.paths.authDir, `state-${telegramId}.json`);
  }
}

export const userStore = new UserStore();
