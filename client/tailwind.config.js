/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rce: {
          bg: "#f4ead0",
          surface: "#fffbee",
          border: "#d4c9a8",
          text: "#1a1a0e",
          muted: "#5a5838",
          soft: "#8a8668",
          accent: "#c49818",
          accentDark: "#a07a0e",
          accentBg: "#f5edcf",
          success: "#16A34A",
          warning: "#D97706",
          danger: "#DC2626",
          info: "#2563EB",
          navBg: "#1e2d12",
          navText: "#e8d9b4",
        },
      },
      fontFamily: {
        sans: ["Public Sans", "Segoe UI", "sans-serif"],
        heading: ["Bitter", "Georgia", "serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 2px 10px rgba(30, 45, 18, 0.08)",
      },
    },
  },
  plugins: [],
};
