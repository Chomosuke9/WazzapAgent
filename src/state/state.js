import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({
  path: resolve(process.cwd(), ".env"),
});
import { CacheMessage } from "../whatsapp_bot/utils/caching.js";


export const cache = new CacheMessage(process.env.MESSAGE_CACHE_LIMIT || 500);
export const botNumber = (process.env.BOT_NUMBER || "") + "@s.whatsapp.net";
export const port = process.env.PORT || "8765";
export const key = process.env.KEY;
export const authStateFile = process.env.AUTH_STATE_FILE;
