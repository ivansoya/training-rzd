import {
  Activity, Archive, ArrowLeft, ArrowRight, Bell, Bot, Box, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, ChevronsUpDown, Circle, CircleHelp, Clock, Copy, Cpu, Crosshair,
  Database, Diamond, Download, Droplet, Ellipsis, ExternalLink, Eye, EyeOff, Film, Folder,
  Funnel, GripVertical, Hand, History, House, Image, Images, Info, Keyboard, Layers, LayoutGrid, Link2, List,
  Lock, LockOpen, LogOut, Maximize2, Merge, Minimize2, Minus, MousePointer2, Pause, Pencil, Pentagon, Play, Plus,
  Redo2, RefreshCw, RotateCw, Route, Save, Scan, Scissors, Search, Send, Server, Settings, Shuffle,
  SkipBack, SkipForward, SlidersHorizontal, Snowflake, Sparkles, Split, Square, SquareCheckBig,
  SquareDashed, Sun, Tag, Tags, Target, Trash2, TriangleAlert, Undo2, Upload, User, UserMinus, UserPlus,
  Users, Video, Wind, Workflow, X, ZoomIn, ZoomOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cx } from "./cx";

/** Белый список: новое имя добавляется сюда, а не импортом lucide в экране. */
const ICONS = {
  activity: Activity, archive: Archive, back: ArrowLeft, forward: ArrowRight, bell: Bell,
  bot: Bot, box: Box, tick: Check, chevD: ChevronDown, chevL: ChevronLeft, chevR: ChevronRight,
  chevU: ChevronUp, updown: ChevronsUpDown, circle: Circle, help: CircleHelp, clock: Clock,
  copy: Copy, cpu: Cpu, crosshair: Crosshair, database: Database, diamond: Diamond,
  download: Download, drop: Droplet, more: Ellipsis, external: ExternalLink, eye: Eye,
  eyeoff: EyeOff, film: Film, folder: Folder, filter: Funnel, grip: GripVertical, hand: Hand, history: History,
  home: House, image: Image, images: Images, info: Info, keyboard: Keyboard, layers: Layers,
  grid: LayoutGrid, link: Link2, list: List, lock: Lock, unlock: LockOpen, logout: LogOut, fit: Maximize2, merge: Merge,
  minus: Minus, shrink: Minimize2, pointer: MousePointer2, pause: Pause, edit: Pencil, poly: Pentagon, play: Play,
  plus: Plus, redo: Redo2, refresh: RefreshCw, rotate: RotateCw, route: Route, save: Save,
  scan: Scan, cut: Scissors, search: Search, send: Send, server: Server, settings: Settings, shuffle: Shuffle,
  skipb: SkipBack, skipf: SkipForward, sliders: SlidersHorizontal, snow: Snowflake,
  sparkle: Sparkles, split: Split, stop: Square, check: SquareCheckBig, bbox: SquareDashed,
  sun: Sun, tag: Tag, tags: Tags, target: Target, trash: Trash2, alert: TriangleAlert,
  undo: Undo2, upload: Upload, user: User, kick: UserMinus, invite: UserPlus, users: Users, video: Video,
  wind: Wind, workflow: Workflow, x: X, zin: ZoomIn, zout: ZoomOut,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: {
  name: IconName; size?: number; className?: string;
}) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={1.75} aria-hidden="true" className={cx("ui-ic", className)} />;
}

/** Знак продукта — колея, своя картинка, а не иконка из набора. */
export function RailsMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3 5 21M16 3l3 18M6.7 9h10.6M6 14h12M5.3 19h13.4" />
    </svg>
  );
}
