import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff", 100: "#dbeafe", 500: "#2563eb", 600: "#1d4ed8", 700: "#1e40af", 900: "#0f1f4b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
