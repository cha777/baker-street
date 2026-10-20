# Baker Street — BrainxHR Cafe Food Order Automator & Telegram Bot

Automated food order placement and deletion for `https://brainxhr.directfn.net/private/task/cafe-order-food` controlled via a multi-user Telegram Bot with per-user configurable defaults and scheduled daily auto-ordering.

## Features

- **Multi-User Support with Encrypted Credentials**:
  - Any teammate can run `/login` in a private chat with the bot.
  - Password messages are **immediately deleted from the Telegram chat** upon receipt and stored encrypted with **AES-256-GCM** in `data/users.json`.
  - Each user gets an isolated Playwright session (`.auth/state-<telegramId>.json`).
- **Configurable Personal Defaults (`/defaults`)**:
  - **Location**: `ICC Techno Hub` *(Default)*, `Villa`
  - **Order For**: `My self` *(Default)*, `For a colleague`, `For a visitor`
  - **Food Type**: `Chicken` *(Default)*, `Egg`, `Fish`, `Vegetable`
- **Scheduled Daily Auto-Order (`/schedule`)**:
  - Enable/disable automatic daily order placement at your preferred time (`HH:mm` in `Asia/Colombo` timezone, e.g., `08:30` Mon–Fri).
  - Automatically places your default food order and sends a confirmation screenshot to Telegram with a 1-tap **🗑️ Delete This Order** button.
- **On-Demand Ordering & Order Deletion**:
  - **⚡ Quick Order (`/quickorder`)**: 1-tap order using your saved defaults.
  - **🍽️ Custom Order (`/order`)**: Step-by-step inline keyboard (`Location` ➔ `Order For` ➔ `Food Type` ➔ `Submit`).
  - **🗑️ View / Delete Order (`/delete`)**: View placed orders and delete them with a confirmation screenshot.

---

## Quick Start

### 1. Install Dependencies & Playwright Browser
```bash
npm install
npx playwright install chromium
```

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env` and fill in your `TELEGRAM_BOT_TOKEN` (from `@BotFather` on Telegram):
```bash
cp .env.example .env
```

### 3. (Optional) Inspect & Calibrate Portal Selectors
To inspect the live DOM structure of `https://brainxhr.directfn.net/private/task/cafe-order-food` and verify selectors:
```bash
npm run inspect
```
This saves `debug-dump/page-structure.json`, `debug-dump/page.html`, and `debug-dump/page.png`.

### 4. Start the Bot
```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start
```
