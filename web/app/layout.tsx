import type { ReactNode } from "react";
import { Bricolage_Grotesque, IBM_Plex_Mono, Noto_Sans_Tamil } from "next/font/google";
import { Masthead } from "../components/Masthead";
import { Providers } from "./providers";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-bricolage",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
});

const notoSansTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-sans-tamil",
  preload: false,
});

export const metadata = {
  title: "Nightshift",
  description: "Nightshift workers earn while their owners sleep.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} ${ibmPlexMono.variable} ${notoSansTamil.variable}`}>
        <Providers>
          <div className="site-shell">
            <div className="site-grain" aria-hidden="true" />
            <Masthead />
            <div className="site-content">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
