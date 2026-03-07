package com.fortress.launcher.security;

import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.platform.win32.Kernel32;
import com.sun.jna.platform.win32.WinDef;
import com.sun.jna.platform.win32.WinNT;
import com.sun.jna.ptr.IntByReference;
import com.sun.jna.win32.StdCallLibrary;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Windows-only module scanner based on PSAPI via JNA.
 */
public class WindowsModuleScanner {

    private static final int PROCESS_QUERY_INFORMATION = 0x0400;
    private static final int PROCESS_VM_READ = 0x0010;
    private static final int MAX_PATH = 1024;

    private final Set<String> suspiciousKeywords;
    private final Psapi psapi;

    public WindowsModuleScanner(Collection<String> suspiciousKeywords) {
        this(suspiciousKeywords, Psapi.INSTANCE);
    }

    WindowsModuleScanner(Collection<String> suspiciousKeywords, Psapi psapi) {
        this.suspiciousKeywords = suspiciousKeywords.stream()
                .map(keyword -> keyword.toLowerCase(Locale.ROOT))
                .collect(Collectors.toUnmodifiableSet());
        this.psapi = psapi;
    }

    /**
     * Enumerates modules loaded in the current process.
     */
    public List<LoadedModule> enumerateCurrentProcessModules() {
        if (!isWindows()) {
            return List.of();
        }

        long pid = ProcessHandle.current().pid();
        WinNT.HANDLE processHandle = Kernel32.INSTANCE.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, (int) pid);
        if (processHandle == null) {
            return List.of();
        }

        try {
            WinDef.HMODULE[] moduleHandles = new WinDef.HMODULE[1024];
            IntByReference bytesNeeded = new IntByReference();

            boolean enumerated = psapi.EnumProcessModules(processHandle, moduleHandles,
                    moduleHandles.length * Native.getNativeSize(WinDef.HMODULE.class), bytesNeeded);
            if (!enumerated) {
                return List.of();
            }

            int moduleCount = bytesNeeded.getValue() / Native.getNativeSize(WinDef.HMODULE.class);
            List<LoadedModule> modules = new ArrayList<>(moduleCount);
            char[] modulePathBuffer = new char[MAX_PATH];

            for (int i = 0; i < moduleCount; i++) {
                WinDef.HMODULE module = moduleHandles[i];
                if (module == null) {
                    continue;
                }
                int length = psapi.GetModuleFileNameExW(processHandle, module, modulePathBuffer, modulePathBuffer.length);
                if (length <= 0) {
                    continue;
                }

                String fullPath = Native.toString(modulePathBuffer);
                String moduleName = extractName(fullPath);
                long baseAddress = Pointer.nativeValue(module.getPointer());
                modules.add(new LoadedModule(moduleName, fullPath, baseAddress));
            }
            return modules;
        } finally {
            Kernel32.INSTANCE.CloseHandle(processHandle);
        }
    }

    /**
     * Filters loaded modules with suspicious keywords.
     */
    public List<LoadedModule> findSuspiciousModules() {
        return enumerateCurrentProcessModules().stream()
                .filter(module -> matchesSuspiciousKeyword(module.path(), module.name()))
                .collect(Collectors.toUnmodifiableList());
    }

    private boolean matchesSuspiciousKeyword(String path, String name) {
        String haystack = (path + " " + name).toLowerCase(Locale.ROOT);
        return suspiciousKeywords.stream().anyMatch(haystack::contains);
    }

    private String extractName(String fullPath) {
        int sep = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
        return sep >= 0 ? fullPath.substring(sep + 1) : fullPath;
    }

    private boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    interface Psapi extends StdCallLibrary {
        Psapi INSTANCE = Native.load("psapi", Psapi.class);

        boolean EnumProcessModules(WinNT.HANDLE hProcess, WinDef.HMODULE[] lphModule, int cb, IntByReference lpcbNeeded);

        int GetModuleFileNameExW(WinNT.HANDLE hProcess, WinDef.HMODULE hModule, char[] lpFilename, int nSize);
    }
}
