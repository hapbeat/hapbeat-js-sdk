/**
 * Minimal ambient types for the part of `react-native` the React Native
 * transport uses (AppState), so this package builds without React Native
 * installed. The app provides the real module at runtime.
 */
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

  export interface NativeEventSubscription {
    remove(): void;
  }

  export const AppState: {
    currentState: AppStateStatus;
    addEventListener(type: "change", listener: (state: AppStateStatus) => void): NativeEventSubscription;
  };
}
