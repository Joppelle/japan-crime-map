import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Japan Crime Atlas",
  description: "A privacy-conscious map of Japanese prefectural police crime open data.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${manrope.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
