INSERT INTO system_config (key, value, unit, description) VALUES
  ('subdivision.area_tolerance_ratio', 0.02, 'ratio',
   'Max relative difference allowed between sum(child areas) and parent area'),
  ('subdivision.overlap_tolerance_m2', 0.5, 'm2',
   'Max overlap area allowed between subdivision children, or between a child and a neighbouring parcel'),
  ('subdivision.containment_tolerance_m2', 0.5, 'm2',
   'Max area of a child allowed to fall outside the parent boundary'),
  ('subdivision.coverage_gap_tolerance_m2', 0.5, 'm2',
   'Max uncovered area of the parent left by the union of the children'),
  ('subdivision.min_plot_size_m2', 30, 'm2',
   'Minimum permitted area for a single subdivision child'),
  ('qa.sliver_area_threshold_m2', 5, 'm2',
   'Active parcels at or below this area are reported by /qa/report as slivers'),
  ('qa.area_mismatch_tolerance_ratio', 0.05, 'ratio',
   'Relative difference between declared_area and computed area above which /qa/report flags a mismatch'),
  ('qa.overlap_area_threshold_m2', 0.5, 'm2',
   'Two active parcels are reported as overlapping only if the intersection area exceeds this')
ON CONFLICT (key) DO NOTHING;
