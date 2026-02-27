import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Zanzo Test App — Multi-Workspace Portal',
    description: 'End-to-end test of Zanzo ReBAC with dynamic modules per workspace',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
