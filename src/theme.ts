import { MD3DarkTheme, type MD3Theme } from "react-native-paper";

// t3-style dark: near-black zinc, single indigo accent, sharp corners.
export const theme: MD3Theme = {
  ...MD3DarkTheme,
  roundness: 2,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#818cf8",
    onPrimary: "#09090b",
    primaryContainer: "#312e81",
    onPrimaryContainer: "#e0e7ff",
    background: "#09090b",
    onBackground: "#fafafa",
    surface: "#101013",
    onSurface: "#fafafa",
    surfaceVariant: "#18181c",
    onSurfaceVariant: "#a1a1aa",
    outline: "#27272a",
    outlineVariant: "#1c1c20",
    error: "#f87171",
  },
};

export const mono = "monospace";
