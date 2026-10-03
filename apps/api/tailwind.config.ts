import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff", 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa",
          500: "#2563eb", 600: "#1d4ed8", 700: "#1e40af", 800: "#1e3a8a", 900: "#0f1f4b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
