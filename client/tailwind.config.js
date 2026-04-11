/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rce: {
          bg: "#FAFAF9",
          surface: "#FFFFFF",
          border: "#E4E4E0",
          text: "#18181B",
          muted: "#71717A",
          soft: "#A1A1AA",
          accent: "#F59E0B",
          accentDark: "#B45309",
          accentBg: "#FEF3C7",
          success: "#16A34A",
          warning: "#D97706",
          danger: "#DC2626",
          info: "#2563EB",
          navBg: "#1C1917",
          navText: "#D6D3D1",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 2px 10px rgba(24, 24, 27, 0.05)",
      },
    },
  },
  plugins: [],
};
