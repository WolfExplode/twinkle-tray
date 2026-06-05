import React from "react";
import { useEffect, Component } from "react"
import PropTypes from 'prop-types';

export default class Slider extends Component {

    firingEvent = false
    handleChange = (event) => {
        if(event.target.value !== this.props.level)
        this.setState({ level: this.cap(event.target.value) }, this.fireChange)
    }

    handleWheel = (event) => {
        if (this.props.scrolling === false) return false;
        this.setState({ level: this.cap((this.state.level * 1) + Math.round(event.deltaY * -1 * 0.01 * (this.props.scrollAmount ?? 1))) }, this.fireChange)
    }

    fireChange = () => {
        if (this.firingEvent === false && this.props.onChange && typeof this.props.onChange == "function") {
            this.firingEvent = true
            this.props.onChange(this.cap(this.state.level) * 1, this)
            this.firingEvent = false
        }
    }

    getName = () => {
        if (this.props.name) {
            return (
                <div className="name-row">
                    <div className="icon" style={{display: (this.props.icon === false ? "none" : "block")}}>{(this.props.monitortype == "wmi" ? <span>&#xE770;</span> : <span>&#xE7F4;</span>)}</div>
                    <div className="title">{this.props.name}</div>
                    {this.props.afterName}
                </div>
            )
        }
    }

    cap = (level) => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        let capped = level * 1
        if (level < min) {
            capped = min
        } else if (level > max) {
            capped = max
        }
        return capped
    }

    progressStyle = () => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const level = this.cap((this.props.level || 0) * 1)
        return { width: (0 + (((level - min) * (100 / (max - min))))) + "%" }
    }

    // Progress fill for the hardware-brightness zone (0 → thumb), used when min < 0
    hardwareProgressStyle = () => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const totalRange = max - min
        const level = this.cap(this.props.level)
        if (level < 0) return { width: 0 }
        const left = (-min) / totalRange * 100
        const width = level / totalRange * 100
        return { left: left + '%', width: width + '%' }
    }

    // Progress fill for the software-dim zone (thumb → 0-mark), used when min < 0 and level < 0
    softwareDimProgressStyle = () => {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const totalRange = max - min
        const level = this.cap(this.props.level)
        if (level >= 0) return { width: 0 }
        const thumbPos = (level - min) / totalRange * 100
        const width = (-level) / totalRange * 100
        return { left: thumbPos + '%', width: width + '%' }
    }

    constructor(props) {
        super(props);
        this.state = {
            level: this.cap((this.props.level === undefined ? 50 : this.props.level)),
        }
        //this.fireChange()
    }

    componentDidUpdate(oldProps) {
        if (oldProps.max != this.props.max || oldProps.min != this.props.min) {
            this.setState({
                level: this.cap(this.props.level)
            }, this.fireChange())
        }
    }

    render() {
        const min = (this.props.min || 0) * 1
        const max = (this.props.max || 100) * 1
        const level = this.cap(this.props.level)
        const hasSoftwareDim = min < 0
        const totalRange = max - min
        const zeroMarkPos = hasSoftwareDim ? ((-min) / totalRange * 100) + '%' : null
        return (
            <div className="monitor-item" onWheel={this.handleWheel}>
                {this.getName()}
                <div className="input--range" data-height={this.props.height} data-software-dim={hasSoftwareDim && level < 0 ? "active" : undefined}>
                    <div className="rangeGroup">
                        <input type="range" min={min} max={max} value={level} data-percent={level + "%"} onChange={this.handleChange} className="range" />
                        {hasSoftwareDim ? (
                            <>
                                <div className="progress progress-software-dim" style={this.softwareDimProgressStyle()}></div>
                                <div className="progress progress-hardware" style={this.hardwareProgressStyle()}></div>
                                <div className="dim-zone-marker" style={{ left: zeroMarkPos }}></div>
                            </>
                        ) : (
                            <div className="progress" style={this.progressStyle()}></div>
                        )}
                    </div>
                    <input type="number" min={min} max={max} value={Math.floor(level)} onChange={this.handleChange} className="val" />
                </div>
            </div>
        );
    }

};