//! Tauri commands over the overhang classifier in `dragonfruit-mesh-scan`.

pub use dragonfruit_mesh_scan::overhang::*;

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and classify overhang regions with projected-footprint masks. Stateless —
/// no model cache. Mirrors `scan_mesh_minima`'s shape.
///
/// Also emits the topple report ([`compute_stability_report`]) on the same
/// welded soup. This command is the one every model passes through — the
/// sideload path re-classifies here because its triangle ids do not match the
/// rendered geometry, and the client-side fallback has nowhere else to run —
/// so the report is logged here rather than from `scan_islands_from_path`.
#[tauri::command]
pub async fn scan_overhangs(
    positions: Vec<f32>,
    self_support_angle_deg: f32,
    px_mm: f32,
    label: Option<String>,
    has_raft: Option<bool>,
) -> Result<OverhangScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (regions, report) = overhang_and_stability_from_soup(
            &positions,
            self_support_angle_deg,
            px_mm,
            has_raft.unwrap_or(false),
        );
        if let Some(report) = &report {
            log::info!(
                "[stability] {}: {}",
                label.as_deref().unwrap_or("world soup"),
                report.to_log_line(),
            );
            if !regions.is_empty() {
                log::info!(
                    "[stability] regions by drag moment (pose total {:.0}mm³): {}",
                    report.drag_moment_mm3,
                    region_moment_ranking(&regions, report.drag_moment_mm3, 4),
                );
            }
        }
        log::info!(
            "[overhang] scan complete: {} regions from {} triangles",
            regions.len(),
            positions.len() / 9,
        );
        Ok(OverhangScan {
            regions,
            stability: report,
        })
    })
    .await
    .map_err(|e| format!("Overhang scan task panicked: {e}"))?
}

/// Tauri IPC command: weld the staged world-space triangle soup and classify
/// overhang regions plus the topple report.
///
/// The frontend stages exactly the positions it renders, so the returned
/// `triangleIds` index the rendered geometry. This is the binary counterpart
/// of `scan_overhangs`: no JSON number array crosses the boundary. The command
/// consumes the staged buffer.
#[tauri::command]
pub async fn scan_overhangs_staged(
    self_support_angle_deg: f32,
    px_mm: f32,
    label: Option<String>,
    has_raft: Option<bool>,
) -> Result<OverhangScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::staged_mesh()
            .lock()
            .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
            .take()
            .ok_or("No staged mesh binary — call stage_mesh_binary_set first")?;
        let soup = crate::bytes_to_f32_vec(&bytes)?;
        if soup.is_empty() || soup.len() % 9 != 0 {
            return Err(format!(
                "Staged overhang scan needs a triangle soup (9 floats per triangle); got {} floats",
                soup.len()
            ));
        }

        let (regions, report) = overhang_and_stability_from_soup(
            &soup,
            self_support_angle_deg,
            px_mm,
            has_raft.unwrap_or(false),
        );
        if let Some(report) = &report {
            log::info!(
                "[stability] {}: {}",
                label.as_deref().unwrap_or("world soup"),
                report.to_log_line(),
            );
            if !regions.is_empty() {
                log::info!(
                    "[stability] regions by drag moment (pose total {:.0}mm³): {}",
                    report.drag_moment_mm3,
                    region_moment_ranking(&regions, report.drag_moment_mm3, 4),
                );
            }
        }
        log::info!(
            "[overhang] staged scan complete: {} regions from {} triangles",
            regions.len(),
            soup.len() / 9,
        );
        Ok(OverhangScan {
            regions,
            stability: report,
        })
    })
    .await
    .map_err(|e| format!("Staged overhang scan task panicked: {e}"))?
}

