# openEMS built from source (latest upstream): adds series/parallel lumped RLC
# elements and other fixes that the Debian-packaged 0.0.35 lacks.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1 PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
      libhdf5-dev libvtk9-dev libboost-all-dev libcgal-dev libtinyxml-dev \
      python3-dev python3-pip python3-setuptools python3-wheel cython3 \
      python3-numpy python3-h5py python3-matplotlib \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*
RUN git clone --recursive --depth 1 --shallow-submodules \
      https://github.com/thliebig/openEMS-Project.git /src/openEMS-Project
WORKDIR /src/openEMS-Project
RUN ./update_openEMS.sh /opt/openEMS --disable-GUI --python || (tail -60 build_*.log; exit 1)
ENV PATH=/opt/openEMS/venv/bin:/opt/openEMS/bin:$PATH LD_LIBRARY_PATH=/opt/openEMS/lib
WORKDIR /job
