import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Backend API base URL.
 * - Production: set NEXT_PUBLIC_API_URL=https://your-backend.onrender.com
 * - Or leave empty and use Next.js rewrite proxy (see next.config.mjs)
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export const COUNTRIES = [
  "India",
  "United States",
  "United Kingdom",
  "United Arab Emirates",
  "Australia",
  "Canada",
  "Germany",
  "France",
  "Singapore",
  "Saudi Arabia",
  "Qatar",
  "Bangladesh",
  "Pakistan",
  "Nepal",
  "Sri Lanka",
];
