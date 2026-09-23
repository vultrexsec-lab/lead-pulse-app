import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata = {
  title: "Lead Pulse - WhatsApp Extractor",
  description: "Extract leads and verify which numbers are active on WhatsApp.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full bg-[#070b10] text-slate-100">{children}</body>
    </html>
  );
}
