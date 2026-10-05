

export interface ThemeMetadata {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  variant: 'light' | 'dark';
  tags: string[];
  source?: Record<string, unknown>;
  validation?: Record<string, unknown>;
}

export interface PaletteColor {
  key: string;
  name: string;
  hex: string;
  foreground: string;
  contrast: number;
}

export interface ThemePalette {
  version: number;
  colors: PaletteColor[];
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ThemeColor {
  base: string;
  hover?: string;
  active?: string;
  foreground?: string;
  muted?: string;
  emphasis?: string;
}

export interface SurfaceColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  elevated: string;
  elevatedForeground: string;
  /** Плавающие слои (меню/поповер). Опционально — фоллбек на `elevated`. */
  raised?: string;
  /** Текст на `raised`. Опционально — фоллбек на `elevatedForeground`. */
  raisedForeground?: string;
  overlay: string;
  subtle: string;
}

export interface InteractiveColors {
  border: string;
  borderHover: string;
  borderFocus: string;
  selection: string;
  selectionForeground: string;
  focus: string;
  focusRing: string;
  cursor: string;
  hover: string;
  active: string;
}

export interface StatusColors {
  error: string;
  errorForeground: string;
  errorBackground: string;
  errorBorder: string;

  warning: string;
  warningForeground: string;
  warningBackground: string;
  warningBorder: string;

  success: string;
  successForeground: string;
  successBackground: string;
  successBorder: string;

  info: string;
  infoForeground: string;
  infoBackground: string;
  infoBorder: string;
}

export interface PullRequestColors {
  open: string;
  draft: string;
  blocked: string;
  merged: string;
  closed: string;
}

export interface SyntaxBaseColors {
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
}

export interface SyntaxColors {
  base: SyntaxBaseColors;
  tokens?: Partial<Record<string, string>>;
}

export interface ButtonVariant {
  bg?: string;
  fg?: string;
  border?: string;
  hover?: string;
  active?: string;
  disabled?: string;
}

export interface TypographyStyle {
  fontSize: string;
  lineHeight: string;
  letterSpacing?: string;
  fontWeight?: string | number;
}

export interface TypographyScale {
  xs: TypographyStyle;
  sm: TypographyStyle;
  base: TypographyStyle;
  lg: TypographyStyle;
  xl: TypographyStyle;
  '2xl': TypographyStyle;
  '3xl': TypographyStyle;
  '4xl': TypographyStyle;
  '5xl': TypographyStyle;
}

export interface HeadingStyles {
  h1: TypographyStyle;
  h2: TypographyStyle;
  h3: TypographyStyle;
  h4: TypographyStyle;
  h5: TypographyStyle;
  h6: TypographyStyle;
}

export interface UITypography {
  button: TypographyStyle;
  buttonSmall: TypographyStyle;
  buttonLarge: TypographyStyle;
  label: TypographyStyle;
  caption: TypographyStyle;
  badge: TypographyStyle;
  tooltip: TypographyStyle;
  input: TypographyStyle;
  helperText: TypographyStyle;
}

export interface CodeTypography {
  inline: TypographyStyle;
  block: TypographyStyle;
  lineNumbers: TypographyStyle;
}

export interface MarkdownTypography {
  h1: TypographyStyle;
  h2: TypographyStyle;
  h3: TypographyStyle;
  h4: TypographyStyle;
  h5: TypographyStyle;
  h6: TypographyStyle;
  body: TypographyStyle;
  bodySmall: TypographyStyle;
  bodyLarge: TypographyStyle;
  blockquote: TypographyStyle;
  list: TypographyStyle;
  link: TypographyStyle;
  code: TypographyStyle;
  codeBlock: TypographyStyle;
}

export interface SemanticTypography {

  markdown?: string;
  code?: string;
  uiHeader?: string;
  uiLabel?: string;
  meta?: string;
  micro?: string;
}

export interface Typography {

  scale?: TypographyScale;
  heading?: HeadingStyles;
  ui?: UITypography;
  code?: CodeTypography;
  markdown?: MarkdownTypography;

  semantic?: SemanticTypography;
}

export interface Theme {
  metadata: ThemeMetadata;

  colors: {

    primary: ThemeColor;
    surface: SurfaceColors;
    interactive: InteractiveColors;
    status: StatusColors;
    pr?: PullRequestColors;

    syntax: SyntaxColors;

    charts?: Record<string, string | string[]>;
    chat?: Record<string, string>;
    loading?: Record<string, string>;
    tools?: {
      background?: string;
      border?: string;
      headerHover?: string;
      icon?: string;
      title?: string;
      description?: string;
      edit?: Record<string, string>;
    };
    markdown?: Record<string, string>;
  };

  palette?: ThemePalette;

  config?: {
    fonts?: {
      sans?: string;
      mono?: string;
      heading?: string;
    };
    spacing?: {
      xs?: string;
      sm?: string;
      md?: string;
      lg?: string;
      xl?: string;
    };
    transitions?: {
      fast?: string;
      normal?: string;
      slow?: string;
    };
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface AccessibilityIssue {
  foreground: string;
  background: string;
  ratio: number;
  requirement: number;
  pass: boolean;
  context: string;
}

export interface AccessibilityReport {
  wcagAA: boolean;
  wcagAAA: boolean;
  issues: AccessibilityIssue[];
}
