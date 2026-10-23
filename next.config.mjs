// The carousel's text step reads the Poppins fonts from assets/fonts at run time (lib/overlay.ts). No code
// imports them, so the bundler would not ship them: list them for every route that runs the job steps.
const FONTS = ["./assets/fonts/*.ttf"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/cron/tick": FONTS,
    "/api/jobs/[id]/advance": FONTS,
  },
};

export default nextConfig;
