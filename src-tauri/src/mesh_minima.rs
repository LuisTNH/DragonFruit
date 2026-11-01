//! Tauri commands over the mesh scanners in `dragonfruit-mesh-scan`: mesh
//! minima, voxel islands from a file, and the combined voxel + minima +
//! overhang scan. The scanners themselves live in the crate so the CLI can
//! run them without Tauri.

use dragonfruit_islands::{
    model::{Connectivity, GridRef, IslandScanJob},
    stream::run_island_scan_streaming,
};
use dragonfruit_mesh_repair::{core::mesh::Vec3, IndexedMesh};
use std::collections::HashSet;
use tauri::Emitter;

pub use dragonfruit_mesh_scan::minima::*;

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and return all local vertical minima. Stateless — no model cache (the cache
/// in the original only served the dropped brush-proposal feature).
#[tauri::command]
pub async fn scan_mesh_minima(
    positions: Vec<f32>,
    k: Option<usize>,
) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = IndexedMesh::from_triangle_soup(&positions, 1e-5);
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        let local_minima = scan_minima_internal(&mesh, k);

        log::info!(
            "[mesh-minima] scan complete: {} minima from {} vertices / {} triangles",
            local_minima.len(),
            vert_count,
            tri_count,
        );
        Ok(local_minima)
    })
    .await
    .map_err(|e| format!("Minima scan task panicked: {e}"))?
}

#[tauri::command]
pub async fn scan_mesh_minima_from_path(
    file_path: String,
    matrix: [f32; 16],
    center: [f32; 3],
    k: Option<usize>,
) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = load_and_transform_mesh(&file_path, matrix, center)?;
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        let local_minima = scan_minima_internal(&mesh, k);

        log::info!(
            "[mesh-minima-path] scan complete: {} minima from {} vertices / {} triangles",
            local_minima.len(),
            vert_count,
            tri_count,
        );
        Ok(local_minima)
    })
    .await
    .map_err(|e| format!("Minima path scan task panicked: {e}"))?
}

#[tauri::command]
pub async fn scan_voxel_islands_from_path(
    file_path: String,
    matrix: [f32; 16],
    center: [f32; 3],
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
) -> Result<Vec<VoxelIsland>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Load and transform mesh
        let mesh = load_and_transform_mesh(&file_path, matrix, center)?;

        // 2. Convert to flat triangle soup and parse into slicing engine triangles
        let soup = mesh.to_triangle_soup();
        let triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&soup);

        // 3. Get transformed bounding box
        let bbox = mesh.bbox();

        // 4. Calculate grid bounds and dimensions (matching rasterize_for_island_scan)
        let ox = bbox.min.x as f64;
        let oz = -bbox.max.y as f64;
        let gw = ((bbox.max.x as f64 - bbox.min.x as f64) / px_mm)
            .ceil()
            .max(1.0) as i32;
        let gh = ((bbox.max.y as f64 - bbox.min.y as f64) / px_mm)
            .ceil()
            .max(1.0) as i32;
        let model_height = bbox.max.z as f64 - bbox.min.z as f64;
        let num_layers = (model_height / layer_height_mm).ceil().max(0.0) as usize;

        // 5. Run island scan pipeline using streaming
        let connectivity_enum = if connectivity == 8 {
            Connectivity::Eight
        } else {
            Connectivity::Four
        };

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: connectivity_enum,
            min_island_area_mm2: 0.0001, // extremely small area threshold to catch all islands
            layer_height_mm,
            grid: GridRef {
                origin_x: ox,
                origin_z: oz,
                width: gw,
                height: gh,
                px_mm,
            },
            num_layers: num_layers as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };

        let scan_result =
            run_island_scan_streaming(&job, &triangles, bbox.min.z as f64, bbox.max.z as f64, false, None);

        // 5a. Build Z-bucket index for projection raycasting
        let z_min = bbox.min.z;
        let z_max = bbox.max.z;
        let z_range = (z_max - z_min) as f32;
        let num_buckets = 128;
        let mut z_buckets = vec![Vec::new(); num_buckets];
        let tri_count = mesh.triangle_count();
        for fi in 0..tri_count {
            let [v0, v1, v2] = mesh.tri_positions(fi as u32);
            let t_min_z = v0.z.min(v1.z).min(v2.z);
            let t_max_z = v0.z.max(v1.z).max(v2.z);
            if z_range > 1e-5 {
                let b_start = (((t_min_z - z_min) / z_range) * (num_buckets as f32 - 1.0))
                    .floor()
                    .max(0.0) as usize;
                let b_end = (((t_max_z - z_min) / z_range) * (num_buckets as f32 - 1.0))
                    .ceil()
                    .min(num_buckets as f32 - 1.0) as usize;
                for b in b_start..=b_end {
                    z_buckets[b].push(fi as u32);
                }
            } else {
                z_buckets[0].push(fi as u32);
            }
        }

        // Define a helper closure to snap a raw world contact coordinate to the mesh surface
        let snap_to_mesh = |raw_x: f32, raw_y: f32, raw_z: f32| -> Vec3 {
            let epsilon = (layer_height_mm * 1.5) as f32;
            let mut best_hit: Option<(Vec3, f32)> = None;
            let mut best_hit_normal: Option<Vec3> = None;

            let search_min_z = (raw_z - epsilon) as f64;
            let search_max_z = (raw_z + epsilon) as f64;

            let mut candidates = HashSet::new();
            if z_range > 1e-5 {
                let b_start = (((search_min_z - z_min as f64) / z_range as f64)
                    * (num_buckets as f64 - 1.0))
                    .floor()
                    .max(0.0) as usize;
                let b_end = (((search_max_z - z_min as f64) / z_range as f64)
                    * (num_buckets as f64 - 1.0))
                    .ceil()
                    .min(num_buckets as f64 - 1.0) as usize;
                for b in b_start..=b_end {
                    for &fi in &z_buckets[b] {
                        candidates.insert(fi);
                    }
                }
            } else {
                candidates.extend(z_buckets[0].iter().cloned());
            }

            let ray_down_orig = Vec3::new(raw_x, raw_y, raw_z + epsilon);
            let ray_down_dir = Vec3::new(0.0, 0.0, -1.0);

            let ray_up_orig = Vec3::new(raw_x, raw_y, raw_z - epsilon);
            let ray_up_dir = Vec3::new(0.0, 0.0, 1.0);

            for fi in candidates {
                let [v0, v1, v2] = mesh.tri_positions(fi);

                // Ray down test
                if let Some(t) =
                    ray_triangle_intersect(&ray_down_orig, &ray_down_dir, &v0, &v1, &v2)
                {
                    if t <= 2.0 * epsilon {
                        let hit_z = ray_down_orig.z - t;
                        let normal = mesh.tri_normal(fi);
                        let is_downward = normal.z < 0.0;
                        let dist_z = (hit_z - raw_z).abs();

                        let replace = match best_hit {
                            None => true,
                            Some((_, best_dist)) => {
                                let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                                let best_was_downward = best_normal.z < 0.0;
                                if is_downward && !best_was_downward {
                                    true
                                } else if !is_downward && best_was_downward {
                                    false
                                } else {
                                    dist_z < best_dist
                                }
                            }
                        };

                        if replace {
                            best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                            best_hit_normal = Some(normal);
                        }
                    }
                }

                // Ray up test
                if let Some(t) = ray_triangle_intersect(&ray_up_orig, &ray_up_dir, &v0, &v1, &v2) {
                    if t <= 2.0 * epsilon {
                        let hit_z = ray_up_orig.z + t;
                        let normal = mesh.tri_normal(fi);
                        let is_downward = normal.z < 0.0;
                        let dist_z = (hit_z - raw_z).abs();

                        let replace = match best_hit {
                            None => true,
                            Some((_, best_dist)) => {
                                let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                                let best_was_downward = best_normal.z < 0.0;
                                if is_downward && !best_was_downward {
                                    true
                                } else if !is_downward && best_was_downward {
                                    false
                                } else {
                                    dist_z < best_dist
                                }
                            }
                        };

                        if replace {
                            best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                            best_hit_normal = Some(normal);
                        }
                    }
                }
            }

            if let Some((hit_pt, _)) = best_hit {
                hit_pt
            } else {
                Vec3::new(raw_x, raw_y, raw_z)
            }
        };

        // 6. Convert tracking result back to VoxelIslands
        let mut voxel_islands = Vec::new();
        for (idx, island) in scan_result.islands.iter().enumerate() {
            // Retrieve first layer's centroid (seed_voxel)
            if let Some(seed) = island.seed_voxel {
                // Map pixel coordinates to world coordinates
                let contact_x = ox + seed.x * px_mm + px_mm * 0.5;
                let contact_y = -(oz + seed.y * px_mm);
                let contact_z = bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm;
                let contact = snap_to_mesh(contact_x as f32, contact_y as f32, contact_z as f32);

                voxel_islands.push(VoxelIsland {
                    id: format!("v{}", idx),
                    source: "voxel".to_string(),
                    contact,
                    base_z: contact_z,
                    // Contact footprint = base-layer area, not accumulated area.
                    area_mm2: island
                        .per_layer_area_mm2
                        .get(&island.first_layer)
                        .copied()
                        .unwrap_or(island.total_area_mm2) as f32,
                    layer_span: [island.first_layer, island.last_layer],
                    contact_voxels: Vec::new(),
                });
            } else {
                // Fallback to global centroid if seed_voxel is somehow missing
                if let Some(c) = island.centroid {
                    let contact_x = ox + c.x * px_mm + px_mm * 0.5;
                    let contact_y = -(oz + c.y * px_mm);
                    let contact_z = bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm;
                    let contact =
                        snap_to_mesh(contact_x as f32, contact_y as f32, contact_z as f32);

                    voxel_islands.push(VoxelIsland {
                        id: format!("v{}", idx),
                        source: "voxel".to_string(),
                        contact,
                        base_z: contact_z,
                        area_mm2: island
                            .per_layer_area_mm2
                            .get(&island.first_layer)
                            .copied()
                            .unwrap_or(island.total_area_mm2) as f32,
                        layer_span: [island.first_layer, island.last_layer],
                        contact_voxels: Vec::new(),
                    });
                }
            }
        }

        log::info!(
            "[voxel-islands-path] scan complete: {} islands from {} layers",
            voxel_islands.len(),
            num_layers
        );
        Ok(voxel_islands)
    })
    .await
    .map_err(|e| format!("Voxel path scan task panicked: {e}"))?
}

#[tauri::command]
pub async fn scan_islands_from_path(
    app: crate::DragonFruitAppHandle,
    file_path: String,
    matrix: [f32; 16],
    center: [f32; 3],
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
    k: Option<usize>,
    overhang_self_support_angle_deg: Option<f32>,
    overhang_px_mm: Option<f32>,
    overhang_from_staged: Option<bool>,
    has_raft: Option<bool>,
) -> Result<CombinedIslandScanResult, String> {
    // The frontend stages the soup it renders so overhang ids index the
    // overlay geometry. A missing buffer falls back to the file mesh.
    let staged_overhang_soup: Option<Vec<f32>> = if overhang_from_staged.unwrap_or(false) {
        let bytes = crate::staged_mesh()
            .lock()
            .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
            .take();
        match bytes {
            Some(bytes) => Some(crate::bytes_to_f32_vec(&bytes)?),
            None => {
                log::warn!(
                    "[islands-combined] overhang_from_staged was set but no mesh was staged; using the file mesh"
                );
                None
            }
        }
    } else {
        None
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mesh = load_and_transform_mesh(&file_path, matrix, center)?;
        let staged_overhang_mesh = staged_overhang_soup
            .as_deref()
            .map(|soup| IndexedMesh::from_triangle_soup(soup, 1e-5));
        let progress = |done: u32| {
            let _ = app.emit("island-scan-progress", serde_json::json!({ "done": done, "total": 100 }));
        };
        scan_islands_from_mesh(
            &progress,
            mesh,
            staged_overhang_mesh,
            layer_height_mm,
            px_mm,
            support_buffer_mm,
            connectivity,
            k,
            overhang_self_support_angle_deg,
            overhang_px_mm,
            has_raft,
        )
    })
    .await
    .map_err(|e| format!("Combined island scan panicked: {e}"))?
}

/// Combined island scan against the staged world-space triangle soup.
///
/// This is the pathless-model entrypoint (a VOXL has no source file): the
/// frontend stages exactly the positions it renders, so every returned
/// `triangleId` indexes the rendered geometry. It consumes the staged buffer.
#[tauri::command]
pub async fn scan_islands_staged(
    app: crate::DragonFruitAppHandle,
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
    k: Option<usize>,
    overhang_self_support_angle_deg: Option<f32>,
    overhang_px_mm: Option<f32>,
    has_raft: Option<bool>,
) -> Result<CombinedIslandScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::staged_mesh()
            .lock()
            .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
            .take()
            .ok_or("No staged mesh binary — call stage_mesh_binary_set first")?;
        let soup = crate::bytes_to_f32_vec(&bytes)?;
        if soup.is_empty() || soup.len() % 9 != 0 {
            return Err(format!(
                "Staged island scan needs a triangle soup (9 floats per triangle); got {} floats",
                soup.len()
            ));
        }
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        let progress = |done: u32| {
            let _ = app.emit("island-scan-progress", serde_json::json!({ "done": done, "total": 100 }));
        };
        scan_islands_from_mesh(
            &progress,
            mesh,
            None,
            layer_height_mm,
            px_mm,
            support_buffer_mm,
            connectivity,
            k,
            overhang_self_support_angle_deg,
            overhang_px_mm,
            has_raft,
        )
    })
    .await
    .map_err(|e| format!("Staged island scan panicked: {e}"))?
}
