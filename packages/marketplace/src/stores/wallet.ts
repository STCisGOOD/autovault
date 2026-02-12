/**
 * Wallet store — nanostores for connected wallet state.
 */

import { atom, computed } from 'nanostores';

export const $walletConnected = atom<boolean>(false);
export const $walletAddress = atom<string | null>(null);
export const $walletBalance = atom<number | null>(null); // SOL balance
export const $usdcBalance = atom<number | null>(null);

export const $walletDisplayAddress = computed($walletAddress, (addr) => {
  if (!addr) return null;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
});

export function setWalletState(connected: boolean, address: string | null) {
  $walletConnected.set(connected);
  $walletAddress.set(address);
  if (!connected) {
    $walletBalance.set(null);
    $usdcBalance.set(null);
  }
}
