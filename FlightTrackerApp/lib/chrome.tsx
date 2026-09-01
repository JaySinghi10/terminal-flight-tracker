// WHETHER THE APP'S CHROME SHOULD GET OUT OF THE WAY.
//
// ONE BOOLEAN, AND IT IS DELIBERATELY NOT CALLED "the map is being dragged".
// The tab bar is mounted by the navigator and the map is mounted by one screen;
// they have no relationship and must not acquire one. What the bar needs to know
// is not that a map exists but that the user is currently manipulating a
// full-screen surface and would rather have the bottom of the screen back. Any
// future surface that wants the same courtesy sets the same flag, and the bar
// goes on knowing nothing about any of them.
//
// WHY A PROVIDER AT ALL. The bar is a sibling of every screen, not a child of
// one, so a prop cannot reach it and a ref would mean the screen holding a
// handle on the navigator's furniture. lib/query.tsx already solves exactly this
// shape for the command line -- the bar reads the query from a context the
// search screen writes -- and this is the same arrangement for a second value.
//
// SEPARATE FROM QUERY, for the reason _layout gives for keeping query out of the
// saved list: this changes on every touch-down and touch-up on the map, and the
// query changes on every keystroke. A consumer of either must not be woken by
// the other.
import {
  createContext, useContext, useState, useCallback, useMemo,
  type ReactNode,
} from 'react';

type ChromeContextValue = {
  // TRUE WHILE THE CHROME SHOULD BE OUT OF THE WAY. Nothing in here decides
  // WHAT that means -- the tab bar owns its own answer, which is currently to
  // fade to a glyph. A second consumer could answer differently.
  retracted: boolean;
  setRetracted: (on: boolean) => void;
};

const ChromeContext = createContext<ChromeContextValue | null>(null);

// A DEFAULT RATHER THAN A THROW, and this is the one place in this app where
// that is right. useSaved and useMapRoutes throw when they are used outside
// their provider, because a screen without the store is a bug. This is read by
// the TAB BAR, which is mounted by the navigator and may in principle be
// rendered in a tree that has no reason to carry chrome state -- a test, a
// storybook, a future second navigator. Not retracted is a complete and correct
// answer for all of them.
const NEVER_RETRACTED: ChromeContextValue = {
  retracted: false,
  setRetracted: () => {},
};

export function useChrome(): ChromeContextValue {
  return useContext(ChromeContext) ?? NEVER_RETRACTED;
}

export function ChromeProvider({ children }: { children: ReactNode }) {
  const [retracted, setRetractedState] = useState(false);

  // GUARDED AGAINST THE REPEAT, because the page posts a drag start for every
  // touch that moves the map and React would otherwise re-render the whole
  // navigator subtree on each one. Setting a boolean to the value it already
  // holds is a bail-out React makes for free, but only if the value is the
  // same -- so this passes the value rather than a function.
  const setRetracted = useCallback((on: boolean) => {
    setRetractedState(on);
  }, []);

  const value = useMemo(() => ({ retracted, setRetracted }), [retracted, setRetracted]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}
