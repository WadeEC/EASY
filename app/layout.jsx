import "./globals.css";
import ToastHost from "@/lib/toast.jsx";

export const metadata = {
  title: "E.A.S.Y",
  description: "AI-assisted league manager — works on phone, tablet, and desktop",
  manifest: "/manifest.webmanifest",
  themeColor: "#c8102e",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "EASY",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#c8102e",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>{children}<ToastHost /></body>
    </html>
  );
}
