import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Backend API base URL (Render).
 * Override with NEXT_PUBLIC_API_URL if your backend URL is different.
 */
const DEFAULT_BACKEND = "https://lead-pulse-app.onrender.com";

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  DEFAULT_BACKEND
).replace(/\/$/, "");

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
