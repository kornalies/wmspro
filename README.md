This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Deployment Environment Gates

Staging and production deployments are blocked unless real environment values are configured in GitHub Environments and on the target server env file. The validator rejects localhost/test/build databases, placeholder secrets, non-HTTPS app/API URLs, and CI demo credentials.

Production GitHub secrets required:
`PROD_DATABASE_URL`, `PROD_JWT_SECRET`, `PROD_APP_URL`, `PROD_WMS_API_BASE_URL`, `PROD_WMS_COMPANY_CODE`, `PROD_WMS_USERNAME`, `PROD_WMS_PASSWORD`, `PROD_HOST`, `PROD_USER`, `PROD_APP_DIR`, `PROD_SSH_PRIVATE_KEY`.

Staging GitHub secrets required:
`STAGING_DATABASE_URL`, `STAGING_JWT_SECRET`, `STAGING_APP_URL`, `STAGING_WMS_API_BASE_URL`, `STAGING_WMS_COMPANY_CODE`, `STAGING_WMS_USERNAME`, `STAGING_WMS_PASSWORD`, `STAGING_HOST`, `STAGING_USER`, `STAGING_APP_DIR`, `STAGING_SSH_PRIVATE_KEY`.

The server env file sourced by deployment must also include:
`DATABASE_URL`, `JWT_SECRET`, `APP_URL`, `WMS_API_BASE_URL`, `WMS_COMPANY_CODE`, `WMS_USERNAME`, and `WMS_PASSWORD`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
