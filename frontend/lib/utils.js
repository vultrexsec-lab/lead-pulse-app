import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

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
