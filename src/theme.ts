import { MD3DarkTheme, type MD3Theme } from "react-native-paper";

export const theme: MD3Theme = {
  ...MD3DarkTheme,
  roundness: 12,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#fafafa",
    onPrimary: "#09090b",
    primaryContainer: "#27272a",
    onPrimaryContainer: "#fafafa",
    secondary: "#a1a1aa",
    onSecondary: "#09090b",
    secondaryContainer: "#1e1e22",
    onSecondaryContainer: "#e4e4e7",
    tertiary: "#a1a1aa",
    onTertiary: "#09090b",
    tertiaryContainer: "#1e1e22",
    onTertiaryContainer: "#e4e4e7",
    background: "#09090b",
    onBackground: "#fafafa",
    surface: "#111114",
    onSurface: "#fafafa",
    surfaceVariant: "#1a1a1f",
    onSurfaceVariant: "#a1a1aa",
    surfaceDisabled: "rgba(250,250,250,0.12)",
    onSurfaceDisabled: "rgba(250,250,250,0.38)",
    outline: "#27272a",
    outlineVariant: "#1e1e22",
    error: "#f87171",
    onError: "#09090b",
    errorContainer: "#3f1d24",
    onErrorContainer: "#fecdd3",
  },
};

export const mono = "monospace";
