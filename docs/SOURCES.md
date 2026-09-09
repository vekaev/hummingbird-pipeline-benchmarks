# Sources

Every claim on the site that is not our own measurement. Retrieved 2026-09-09.

| # | Claim it supports | Source |
|---|---|---|
| 1 | HDTF dataset definition, test split, and the open evaluation protocol | Zhang et al., "Flow-Guided One-Shot Talking Face Generation with a High-Resolution Audio-Visual Dataset", CVPR 2021. https://openaccess.thecvf.com/content/CVPR2021/papers/Zhang_Flow-Guided_One-Shot_Talking_Face_Generation_With_a_High-Resolution_Audio-Visual_Dataset_CVPR_2021_paper.pdf |
| 2 | The HDTF clips used, and that the mirror ships face-cropped squares rather than original 720p/1080p footage | Hugging Face dataset `global-optima-research/HDTF`. https://huggingface.co/datasets/global-optima-research/HDTF |
| 3 | LSE-D and LSE-C definitions, and the SyncNet confidence/distance protocol | Chung & Zisserman, "Out of time: automated lip sync in the wild", ACCV 2016 workshops; as operationalised by the Wav2Lip evaluation scripts. |
| 4 | That LSE agrees with human judgement below chance, so it is a collapse detector rather than a quality metric | Zhang et al., ICIP 2024, arXiv:2403.06421 — 2AFC agreement 0.2815 for LSE-D and 0.2333 for LSE-C against 0.5 chance. https://arxiv.org/abs/2403.06421 |
| 5 | The "within 1% of the FP32 reference model's accuracy" convention used for the precision gate | MLPerf Inference rules, MLCommons. |
| 6 | Benchmarking practice: never reuse the same input repeatedly, and run untimed warm-up iterations | Gernot Heiser, "Systems Benchmarking Crimes". https://gernot-heiser.org/benchmarking-crimes.html |
| 7 | That `torch.cuda.set_per_process_memory_fraction` bounds only PyTorch's caching allocator, so allocations from other runtimes fall outside it | PyTorch documentation. https://docs.pytorch.org/docs/stable/generated/torch.cuda.memory.set_per_process_memory_fraction.html |
| 8 | That the A100 has no NVENC engine and five NVDEC units, which bounds how many encode-heavy jobs can share one card | NVIDIA Video Encode and Decode GPU Support Matrix. https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new |
| 9 | MIG profile geometry, and that reconfiguration requires draining the node | NVIDIA Multi-Instance GPU User Guide. https://docs.nvidia.com/datacenter/tesla/mig-user-guide/supported-mig-profiles.html |
| 10 | That GPU time-slicing provides no memory or fault isolation between replicas | NVIDIA GPU Operator documentation, GPU sharing. https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html |
| 11 | Published industrial electricity rate used in the owned-hardware cost band | U.S. Energy Information Administration, Electric Power Monthly, table 4. https://www.eia.gov/electricity/sales_revenue_price/pdf/table_4.pdf |
| 12 | Published data-centre PUE used in the same band | Uptime Institute Global Data Center Survey 2024. https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2024.GlobalDataCenterSurvey.Report.pdf |
| 13 | Published colocation asking rates used in the same band | CBRE North America Data Center Trends H2 2025. https://www.cbre.com/insights/books/north-america-data-center-trends-h2-2025 |
| 14 | Serverless GPU per-second rate used for the rate-sensitivity comparison | Replicate pricing. https://replicate.com/pricing |
| 15 | On-demand rate for the A100 40GB the A/B ran on | Lambda GPU cloud pricing. https://lambda.ai/service/gpu-cloud |
| 16 | GPU fault rate used to reason about warm-cluster operations | Grattafiori et al., "The Llama 3 Herd of Models", arXiv:2407.21783 — 419 unexpected interruptions over 54 days on 16,384 H100s. https://arxiv.org/pdf/2407.21783 |
