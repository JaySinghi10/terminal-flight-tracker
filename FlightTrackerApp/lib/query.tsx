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
  createContext, useContext, useState, useCallback, useMemo, type ReactNode,
} from 'react';

type QueryContextValue = {
  query: string;
  setQuery: (q: string) => void;
  // THE INTENT TO SEARCH, AND NOT THE SEARCH. The tab bar's field raises this
  // when Return is pressed; app/search.tsx is what performs it. The bar must not
  // know what a search is, and a callback prop on the bar would be exactly that
  // knowledge arriving by a different route.
  //
  // A COUNTER RATHER THAN A BOOLEAN, because a boolean cannot say "again". Two
  // identical searches in a row are two presses and must run twice, and a flag
  // that is already true has nothing left to change. Every increment is one
  // press, and the reader acts on the CHANGE rather than on the value.
  submitCount: number;
  submit: () => void;
};

const QueryContext = createContext<QueryContextValue | null>(null);

export function useQuery(): QueryContextValue {
  const v = useContext(QueryContext);
  if (v === null) throw new Error('useQuery must be used inside a QueryProvider');
  return v;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  // IT HOLDS NO QUERY OF ITS OWN. What was typed is `query` above; this only
  // says that a press happened, so the reader takes the text from the same
  // render it takes the count from and the two cannot disagree.
  const [submitCount, setSubmitCount] = useState(0);
  // Stable for the life of the provider: it closes over nothing but the
  // dispatcher, and the functional update means it never reads a stale count.
  const submit = useCallback(() => setSubmitCount((c) => c + 1), []);

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
  const value = useMemo(
    () => ({ query, setQuery, submitCount, submit }),
    [query, setQuery, submitCount, submit],
  );

  return (
    <QueryContext.Provider value={value}>
      {children}
    </QueryContext.Provider>
  );
}
