package com.fortress.launcher.security;

/**
 * Represents a DLL or module loaded in a process.
 */
public record LoadedModule(String name, String path, long baseAddress) {
}
