import { createTheme } from "@mui/material/styles";

const amber = "#E8A020";
const amberBright = "#F5B840";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: amber, light: amberBright, dark: "#B87818", contrastText: "#0C0E12" },
    secondary: { main: "#34D399", light: "#6EE7B7", dark: "#059669" },
    success: { main: "#34D399" },
    warning: { main: "#FB923C" },
    error: { main: "#F87171" },
    info: { main: "#60A5FA" },
    background: { default: "#0C0E12", paper: "#111418" },
    text: { primary: "#E8EBF2", secondary: "#8A8FA0", disabled: "#4A4F60" },
    divider: "rgba(255,255,255,0.07)"
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"DM Sans", "Segoe UI", sans-serif',
    h1: { fontFamily: '"Syne", sans-serif', fontWeight: 700, letterSpacing: -0.5 },
    h2: { fontFamily: '"Syne", sans-serif', fontWeight: 700, letterSpacing: -0.4 },
    h3: { fontFamily: '"Syne", sans-serif', fontWeight: 700, letterSpacing: -0.3 },
    h4: { fontFamily: '"Syne", sans-serif', fontWeight: 700, letterSpacing: -0.3 },
    h5: { fontFamily: '"Syne", sans-serif', fontWeight: 700, letterSpacing: -0.2 },
    h6: { fontFamily: '"Syne", sans-serif', fontWeight: 600 },
    subtitle1: { fontWeight: 500 },
    button: { fontWeight: 600, letterSpacing: 0.1, textTransform: "none" as const },
    caption: { fontSize: "0.725rem" },
    overline: { fontFamily: '"Syne", sans-serif', fontWeight: 600, letterSpacing: 1.5, fontSize: "0.70rem" }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: { body: { background: "#0C0E12", color: "#E8EBF2" } }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "#111418",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "none"
        }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: "#111418",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "none",
          transition: "border-color 180ms ease, transform 180ms ease",
          "&:hover": { borderColor: "rgba(232,160,32,0.30)", transform: "translateY(-1px)" }
        }
      }
    },
    MuiCardContent: {
      styleOverrides: { root: { "&:last-child": { paddingBottom: 16 } } }
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: "rgba(12,14,18,0.90)",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          backdropFilter: "blur(12px)",
          boxShadow: "none",
          color: "#E8EBF2"
        }
      }
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          background: "#0E1016",
          borderRight: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "none",
          color: "#E8EBF2"
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          margin: "1px 8px",
          padding: "8px 12px",
          position: "relative",
          transition: "all 160ms ease",
          color: "#8A8FA0",
          fontSize: "0.875rem",
          "&.Mui-selected": {
            backgroundColor: "rgba(232,160,32,0.10)",
            color: "#E8EBF2",
            fontWeight: 600,
            "&:hover": { backgroundColor: "rgba(232,160,32,0.14)" }
          },
          "&:hover": { backgroundColor: "rgba(255,255,255,0.05)", color: "#E8EBF2" }
        }
      }
    },
    MuiListItemIcon: {
      styleOverrides: {
        root: { minWidth: 34, color: "inherit", "& .MuiSvgIcon-root": { fontSize: "1.1rem" } }
      }
    },
    MuiListItemText: {
      styleOverrides: {
        primary: { fontSize: "0.875rem", fontWeight: "inherit", color: "inherit" }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 8,
          fontWeight: 600,
          fontSize: "0.875rem",
          transition: "transform 160ms cubic-bezier(0.23,1,0.32,1), background-color 160ms ease, border-color 160ms ease, box-shadow 200ms cubic-bezier(0.23,1,0.32,1), color 160ms ease",
          "&:active": { transform: "scale(0.97)" }
        },
        contained: {
          background: amber,
          color: "#0C0E12",
          boxShadow: "none",
          "&:hover": { background: amberBright, boxShadow: "0 0 0 4px rgba(232,160,32,0.18)" }
        },
        outlined: {
          borderColor: "rgba(255,255,255,0.13)",
          color: "#E8EBF2",
          "&:hover": { borderColor: "rgba(232,160,32,0.50)", background: "rgba(232,160,32,0.06)", color: amberBright }
        },
        text: {
          color: "#8A8FA0",
          "&:hover": { background: "rgba(255,255,255,0.05)", color: "#E8EBF2" }
        },
        sizeSmall: { fontSize: "0.8125rem", padding: "4px 10px" }
      }
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: "#8A8FA0",
          borderRadius: 8,
          transition: "transform 140ms cubic-bezier(0.23,1,0.32,1), background-color 160ms ease, color 160ms ease",
          "&:hover": { background: "rgba(255,255,255,0.07)", color: "#E8EBF2" },
          "&:active": { transform: "scale(0.94)" }
        }
      }
    },
    MuiTextField: {
      defaultProps: { variant: "outlined" as const },
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            borderRadius: 8,
            backgroundColor: "rgba(255,255,255,0.03)",
            fontSize: "0.9rem",
            "& .MuiOutlinedInput-notchedOutline": { borderColor: "rgba(255,255,255,0.10)" },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: "rgba(255,255,255,0.20)" },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: amber,
              borderWidth: "1px",
              boxShadow: "0 0 0 3px rgba(232,160,32,0.14)"
            }
          },
          "& .MuiInputLabel-root.Mui-focused": { color: amber },
          "& .MuiInputBase-input": { color: "#E8EBF2" }
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
          fontSize: "0.75rem",
          height: 24,
          border: "1px solid rgba(255,255,255,0.08)",
          transition: "transform 140ms cubic-bezier(0.23,1,0.32,1), background-color 160ms ease, border-color 160ms ease, color 160ms ease",
          "&.MuiChip-clickable:active": { transform: "scale(0.95)" }
        },
        colorSuccess: { background: "rgba(52,211,153,0.12)", color: "#34D399", borderColor: "rgba(52,211,153,0.20)" },
        colorWarning: { background: "rgba(251,146,60,0.12)", color: "#FB923C", borderColor: "rgba(251,146,60,0.20)" },
        colorError: { background: "rgba(248,113,113,0.12)", color: "#F87171", borderColor: "rgba(248,113,113,0.20)" },
        colorPrimary: { background: "rgba(232,160,32,0.12)", color: amber, borderColor: "rgba(232,160,32,0.20)" }
      }
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          "& .MuiTableCell-head": {
            color: "#8A8FA0",
            fontWeight: 600,
            fontSize: "0.75rem",
            letterSpacing: 0.5,
            textTransform: "uppercase" as const,
            backgroundColor: "rgba(255,255,255,0.02)",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            padding: "10px 16px"
          }
        }
      }
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: "0.875rem", padding: "10px 16px" }
      }
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          transition: "background 140ms ease",
          "&:hover .MuiTableCell-body": { backgroundColor: "rgba(255,255,255,0.03)" },
          "&:last-child .MuiTableCell-body": { borderBottom: 0 }
        }
      }
    },
    MuiDivider: { styleOverrides: { root: { borderColor: "rgba(255,255,255,0.07)" } } },
    MuiLinearProgress: {
      styleOverrides: {
        root: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 99, height: 5 },
        bar: { background: "linear-gradient(90deg, #E8A020 0%, #F5B840 100%)", borderRadius: 99 }
      }
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "#1E2230",
          border: "1px solid rgba(255,255,255,0.10)",
          fontSize: "0.75rem",
          fontFamily: '"DM Sans", sans-serif',
          borderRadius: 7,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
        },
        arrow: { color: "#1E2230" }
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: { backgroundColor: "#13161E", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 24px 64px rgba(0,0,0,0.6)" }
      }
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: { fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: "1.05rem" }
      }
    },
    MuiMenu: {
      styleOverrides: {
        paper: { backgroundColor: "#13161E", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 16px 40px rgba(0,0,0,0.5)", borderRadius: 10 }
      }
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: "0.875rem",
          borderRadius: 6,
          margin: "2px 6px",
          transition: "background 140ms ease",
          "&:hover": { backgroundColor: "rgba(255,255,255,0.06)" },
          "&.Mui-selected": { backgroundColor: "rgba(232,160,32,0.10)", color: amber }
        }
      }
    },
    MuiSwitch: {
      styleOverrides: {
        root: { padding: 7 },
        track: { borderRadius: 99, backgroundColor: "rgba(255,255,255,0.14)" },
        switchBase: {
          "&.Mui-checked": { "& + .MuiSwitch-track": { backgroundColor: amber, opacity: 0.9 } }
        },
        thumb: { boxShadow: "0 2px 6px rgba(0,0,0,0.4)" }
      }
    },
    MuiFormControlLabel: {
      styleOverrides: { label: { fontSize: "0.875rem" } }
    },
    MuiBadge: {
      styleOverrides: {
        badge: { fontFamily: '"JetBrains Mono", monospace', fontWeight: 600, fontSize: "0.65rem" }
      }
    },
    MuiAvatar: {
      styleOverrides: {
        root: { fontSize: "0.8rem", fontWeight: 700, fontFamily: '"Syne", sans-serif' }
      }
    },
    MuiSkeleton: {
      styleOverrides: { root: { backgroundColor: "rgba(255,255,255,0.05)" } }
    }
  }
});

export default theme;
