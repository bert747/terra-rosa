import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import TooltipHost from "@/components/TooltipHost";

export const metadata: Metadata = {
  title: "Terra Rosa — Room Management",
  description: "Internal room, booking and occupancy tool for Terra Rosa",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
        <TooltipHost />
      </body>
    </html>
  );
}
