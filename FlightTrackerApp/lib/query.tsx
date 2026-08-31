// What has been typed into the tab bar's search field, and nothing else.
//
// A SECOND CONTEXT RATHER THAN A FIELD ON THE FIRST, and the separation is the
// whole point of the file.
//
// A context re-renders every consumer whenever its value changes. The saved
// context changes when the list is written, the account switches or a pull
// starts and ends — a handful of times a session. This one changes ON EVERY
// KEYSTROKE. Putting the query on the saved provider would have made the home
// screen, which reads the list and the account, re-render once per character
// typed into a control it does not own and cannot see. Nothing on home would
// have looked different; it would simply have re-rendered a thousand-line tree
// to discover that.
//
// So the two are kept apart at the only place the split can be made: at the
// provider. Consumers subscribe to the context they actually read, and a
// keystroke reaches nobody but the field and whatever is deliberately watching
// the query.
//
// IT HOLDS THE TEXT AND NOT THE SEARCH. Whether the bar is collapsed, whether
// the keyboard is up, where the pill is and what the field looks like are all
// facts about the BAR and stay in GlassTabBar's own state. This is the one thing
// that is not: a string another screen will want to read.
import {
  createContext, useContext, useState, useMemo, type ReactNode,
} from 'react';

type QueryContextValue = {
  query: string;
  setQuery: (q: string) => void;
};

const QueryContext = createContext<QueryContextValue | null>(null);

export function useQuery(): QueryContextValue {
  const v = useContext(QueryContext);
  if (v === null) throw new Error('useQuery must be used inside a QueryProvider');
  return v;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');

  // THE SETTER NEEDS NO useCallback and would not be improved by one. It is
  // React's own dispatcher from useState, which is stable for the life of the
  // component by guarantee — wrapping it would add an indirection whose identity
  // is no more stable than the thing it wraps.
  //
  // SO THE MEMO'S ONLY REAL DEPENDENCY IS `query`, which is exactly right: this
  // value changes when the text changes and at no other time. setQuery is listed
  // because it is a field of the object, on the same rule the saved context
  // follows — the array is the object's fields, one for one, and a field left
  // out is a value whose contents disagree with the render it came from.
  const value = useMemo(() => ({ query, setQuery }), [query, setQuery]);

  return (
    <QueryContext.Provider value={value}>
      {children}
    </QueryContext.Provider>
  );
}
