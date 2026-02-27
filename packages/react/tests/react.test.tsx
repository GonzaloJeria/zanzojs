import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ZanzoProvider, useZanzo } from '../src/index';

describe('@zanzojs/react', () => {
    const mockSnapshot = {
        'Invoice:123': ['read'],
        'Project:99': ['write']
    };

    it('should throw an error if used outside ZanzoProvider', () => {
        // Suppress React error boundaries logs in test output
        const consoleError = console.error;
        console.error = () => { };

        expect(() => renderHook(() => useZanzo())).toThrow('useZanzo must be used within a ZanzoProvider');

        console.error = consoleError;
    });

    it('should successfully evaluate active permissions using the provided snapshot', () => {
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <ZanzoProvider snapshot={mockSnapshot}>
                {children}
            </ZanzoProvider>
        );

        const { result } = renderHook(() => useZanzo(), { wrapper });

        expect(result.current.can('read', 'Invoice:123')).toBe(true);
    });

    it('should explicitly reject inactive or missing permissions using the snapshot', () => {
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <ZanzoProvider snapshot={mockSnapshot}>
                {children}
            </ZanzoProvider>
        );

        const { result } = renderHook(() => useZanzo(), { wrapper });

        expect(result.current.can('delete', 'Invoice:123')).toBe(false);
        expect(result.current.can('write', 'Invoice:123')).toBe(false); // implicit false (missing definition)
    });
});
