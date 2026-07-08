/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        darkBg: "#08090c",
        darkCard: "#11131c",
        darkBorder: "#1e2230",
        accentPurple: "#8a2be2",
        accentBlue: "#0070f3",
        accentGreen: "#00df72",
        glassBg: "rgba(17, 19, 28, 0.75)",
      },
      fontFamily: {
        sans: ["Pretendard", "Inter", "-apple-system", "BlinkMacSystemFont", "Apple SD Gothic Neo", "Segoe UI", "sans-serif"],
        display: ["Pretendard", "Inter", "-apple-system", "BlinkMacSystemFont", "Apple SD Gothic Neo", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
}
