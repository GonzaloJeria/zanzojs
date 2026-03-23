import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ZanzoProvider, useZanzo } from '../src/index.js';

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

    it('should handle missing or invalid snapshot gracefully without crashing', () => {
        const consoleWarn = console.warn;
        console.warn = () => { };

        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <ZanzoProvider snapshot={null as any}>
                {children}
            </ZanzoProvider>
        );

        const { result } = renderHook(() => useZanzo(), { wrapper });

        // Should return false for everything but NOT crash
        expect(result.current.can('read', 'Invoice:123')).toBe(false);
        expect(result.current.listAccessible('Invoice')).toEqual([]);

        console.warn = consoleWarn;
    });

    it('should support strict type inference when a schema is provided', () => {
        // This test mostly serves to verify it compiles with generics
        type MySchema = {
            Document: { actions: ('read' | 'write')[], relations: {} };
        };

        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <ZanzoProvider<MySchema> snapshot={mockSnapshot}>
                {children}
            </ZanzoProvider>
        );

        const { result } = renderHook(() => useZanzo<MySchema>(), { wrapper });

        // The following lines would fail TypeScript compilation if typed incorrectly
        expect(result.current.can('read', 'Document:123')).toBe(false);
        
        // @ts-expect-error - 'invalid-action' is not 'read' | 'write'
        result.current.can('invalid-action', 'Document:123');

        // @ts-expect-error - 'InvalidEntity' is not 'Document'
        result.current.listAccessible('InvalidEntity');
    });
});
