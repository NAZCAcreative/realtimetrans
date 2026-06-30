import "../styles/globals.css";
import React from "react";

export const metadata = {
  title: "LiveSub AI",
  description: "Real-time system audio translation platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased bg-darkBg text-gray-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
