import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NeuroCam - Skrining Dini Potensi Stroke",
  description:
    "Pemantauan nirsentuh berbasis citra wajah: estimasi hemodinamik (rPPG) dan indeks asimetri wajah, dengan panduan triase FAST.",
};

const NAV = [
  { href: "/", label: "Beranda" },
  { href: "/monitor", label: "Pemantauan" },
  { href: "/dashboard", label: "Dasbor Insiden" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-border-subtle bg-surface">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white"
              >
                NC
              </span>
              <span className="text-sm font-semibold tracking-tight">NeuroCam</span>
            </Link>

            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-1.5 text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <div className="flex-1">{children}</div>

        <footer className="border-t border-border-subtle bg-surface">
          <div className="mx-auto w-full max-w-6xl px-6 py-4 text-xs leading-relaxed text-muted">
            <strong className="text-foreground">Bukan alat diagnosis.</strong>{" "}
            Sistem ini adalah prototipe skrining dan belum divalidasi secara klinis.
            Hasil negatif tidak menyingkirkan kemungkinan stroke. Bila ada gejala,
            hubungi 119 atau 112 tanpa menunggu sistem.
          </div>
        </footer>
      </body>
    </html>
  );
}
