//! Mesh scanners behind the Islands panel, outside Tauri so the CLI can run
//! them too: mesh minima, overhang regions with the topple report, and the
//! combined voxel + minima + overhang scan the app's island scan calls.

pub mod minima;
pub mod overhang;
