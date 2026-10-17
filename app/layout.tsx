import type { Metadata } from "next";
import type { ReactNode } from "react";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insta Agent",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
